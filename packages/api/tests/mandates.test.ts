// Spending limits (mandates): the evaluation, the shopper's routes, and how
// checkout enforces them. Real Postgres; only PayPal is faked.
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

import checkoutRoutes from '../src/routes/checkout.routes';
import mandateRoutes from '../src/routes/mandate.routes';
import { mandateService } from '../src/mandates/mandate.service';
import { errorHandler } from '../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v1/checkout', checkoutRoutes);
app.use('/api/v1/mandates', mandateRoutes);
app.use(errorHandler());

const db = new DbFixtures();
let coffee: StoreFixture;
let harbor: StoreFixture;
let coffeeKey: string;
const tag = randomUUID().slice(0, 6);
const NOW = new Date('2026-11-20T15:00:00.000Z');
const D = (v: string) => new Prisma.Decimal(v);
const as = (customerId: string) => ({ Authorization: `Bearer b2c_dev_session::${customerId}` });

async function mandate(customerId: string, over: Partial<Prisma.MandateUncheckedCreateInput> = {}) {
  return prisma.mandate.create({
    data: {
      customerId,
      perPurchaseMax: D('30.00'),
      monthlyCap: D('100.00'),
      allowedMerchantIds: [coffee.merchantId, harbor.merchantId],
      expiresAt: new Date('2026-12-20T00:00:00.000Z'),
      ...over,
    },
  });
}

async function pastOrder(customerId: string, status: CheckoutStatus, amount: string, createdAt = NOW) {
  await prisma.checkoutOrder.create({
    data: {
      customerId,
      merchantId: coffee.merchantId,
      productId: coffee.products.beans,
      subtotal: D(amount),
      amountToPay: D(amount),
      status,
      idempotencyKey: randomUUID(),
      createdAt,
    },
  });
}

beforeAll(async () => {
  holder.fake = createFakePayPal();
  coffee = await db.store('Coffee Co. (mandate test)', {
    rules: [{ name: 'Spend $20, Get $5 Off', spendThreshold: 20, tokenDenomination: 5, minimumTransactionFloor: 10 }],
    products: [{ key: 'beans', name: `Morning Ridge Blend medium roast ${tag}`, price: '28.00' }],
  });
  harbor = await db.store('Harbor (mandate test)', { products: [{ key: 'beans', name: `Harbor House medium roast ${tag}`, price: '25.00' }] });
  coffeeKey = await db.apiKey(coffee.merchantId);
});

afterAll(async () => {
  await db.cleanup();
});

beforeEach(() => {
  holder.fake.reset();
});

describe('mandateService.evaluate', () => {
  it('reports no_mandate when the shopper has set no limits, or revoked them', async () => {
    const customerId = await db.shopper();
    expect(await mandateService.evaluate(customerId, { merchantId: coffee.merchantId, amount: D('5.00') }, NOW)).toMatchObject({ within: false, code: 'no_mandate' });

    await mandate(customerId, { status: 'REVOKED', revokedAt: NOW });
    expect(await mandateService.evaluate(customerId, { merchantId: coffee.merchantId, amount: D('5.00') }, NOW)).toMatchObject({ within: false, code: 'no_mandate' });
  });

  it('allows exactly the per-purchase maximum and refuses one cent over', async () => {
    const customerId = await db.shopper();
    await mandate(customerId);

    expect(await mandateService.evaluate(customerId, { merchantId: coffee.merchantId, amount: D('30.00') }, NOW)).toMatchObject({ within: true });
    const over = await mandateService.evaluate(customerId, { merchantId: coffee.merchantId, amount: D('30.01') }, NOW);
    expect(over).toMatchObject({ within: false, code: 'over_per_purchase_max' });
    expect(over.within === false && over.message).toContain('$30.00');
  });

  it('counts open and completed orders this month toward the monthly cap, but not cancelled, failed, refunded or last month', async () => {
    const customerId = await db.shopper();
    await mandate(customerId, { perPurchaseMax: D('50.00') }); // only the monthly cap is in play here
    await pastOrder(customerId, CheckoutStatus.COMPLETED, '40.00');
    await pastOrder(customerId, CheckoutStatus.CREATED, '30.00');
    await pastOrder(customerId, CheckoutStatus.REFUNDED, '25.00');
    await pastOrder(customerId, CheckoutStatus.CANCELLED, '25.00');
    await pastOrder(customerId, CheckoutStatus.FAILED, '25.00');
    await pastOrder(customerId, CheckoutStatus.COMPLETED, '25.00', new Date('2026-10-31T23:00:00.000Z'));

    // $70.00 counts, so $30.00 more reaches the $100.00 cap exactly.
    expect(await mandateService.evaluate(customerId, { merchantId: coffee.merchantId, amount: D('30.00') }, NOW)).toMatchObject({ within: true });
    const over = await mandateService.evaluate(customerId, { merchantId: coffee.merchantId, amount: D('30.01') }, NOW);
    expect(over).toMatchObject({ within: false, code: 'over_monthly_cap' });
    expect(over.within === false && over.message).toContain('$70.00');
  });

  it('blocks expired limits and stores that are not on the list', async () => {
    const expiredShopper = await db.shopper();
    await mandate(expiredShopper, { expiresAt: new Date('2026-11-01T00:00:00.000Z') });
    expect(await mandateService.evaluate(expiredShopper, { merchantId: coffee.merchantId, amount: D('5.00') }, NOW)).toMatchObject({ within: false, code: 'expired' });

    const coffeeOnly = await db.shopper();
    await mandate(coffeeOnly, { allowedMerchantIds: [coffee.merchantId] });
    expect(await mandateService.evaluate(coffeeOnly, { merchantId: harbor.merchantId, amount: D('5.00') }, NOW)).toMatchObject({ within: false, code: 'store_not_allowed' });
  });
});

describe('mandate routes', () => {
  const limits = () => ({ perPurchaseMax: 30, monthlyCap: 100, allowedMerchantIds: [coffee.merchantId, harbor.merchantId], expiresInDays: 30 });

  it('a shopper sets limits, reads them back with what is left this month, and revokes them', async () => {
    const customerId = await db.shopper();

    const created = await request(app).post('/api/v1/mandates').set(as(customerId)).send(limits());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'ACTIVE',
      perPurchaseMax: 30,
      monthlyCap: 100,
      spentThisMonth: 0,
      remainingThisMonth: 100,
      vault: { status: 'NONE' },
    });
    expect(created.body.allowedStores.map((s: { name: string }) => s.name).sort()).toEqual(['Coffee Co. (mandate test)', 'Harbor (mandate test)']);

    const active = await request(app).get('/api/v1/mandates/active').set(as(customerId));
    expect(active.body.mandate).toMatchObject({ id: created.body.id });

    const revoked = await request(app).post(`/api/v1/mandates/${created.body.id}/revoke`).set(as(customerId));
    expect(revoked.body).toMatchObject({ status: 'REVOKED' });
    expect((await request(app).get('/api/v1/mandates/active').set(as(customerId))).body).toEqual({ mandate: null });
  });

  it('setting new limits replaces the old ones', async () => {
    const customerId = await db.shopper();
    const first = await request(app).post('/api/v1/mandates').set(as(customerId)).send(limits());
    const second = await request(app).post('/api/v1/mandates').set(as(customerId)).send({ ...limits(), perPurchaseMax: 20 });

    expect((await prisma.mandate.findUniqueOrThrow({ where: { id: first.body.id } })).status).toBe('REVOKED');
    expect((await request(app).get('/api/v1/mandates/active').set(as(customerId))).body.mandate).toMatchObject({ id: second.body.id, perPurchaseMax: 20 });
  });

  it("only the shopper's own session can set or revoke them", async () => {
    const owner = await db.shopper();
    const other = await db.shopper();
    const created = await request(app).post('/api/v1/mandates').set(as(owner)).send(limits());

    expect((await request(app).post('/api/v1/mandates').set('X-API-Key', coffeeKey).send(limits())).status).toBe(401);
    expect((await request(app).post(`/api/v1/mandates/${created.body.id}/revoke`).set(as(other))).status).toBe(404);
    expect((await prisma.mandate.findUniqueOrThrow({ where: { id: created.body.id } })).status).toBe('ACTIVE');
  });

  it('rejects limits that make no sense', async () => {
    const customerId = await db.shopper();
    for (const body of [
      { ...limits(), perPurchaseMax: 150 },
      { ...limits(), allowedMerchantIds: [] },
      { ...limits(), monthlyCap: -5 },
      { ...limits(), perPurchaseMax: 10.555 },
    ]) {
      expect((await request(app).post('/api/v1/mandates').set(as(customerId)).send(body)).status).toBe(400);
    }
  });
});

describe('checkout with spending limits', () => {
  const buy = (customerId: string, extra: Record<string, unknown> = {}) =>
    request(app).post('/api/v1/checkout/orders').set(as(customerId)).set('Idempotency-Key', randomUUID()).send({ productId: coffee.products.beans, ...extra });

  it('goes ahead inside the limits and refuses one cent over unless the shopper approves it herself', async () => {
    const inside = await db.shopper();
    await db.reward({ customerId: inside, merchantId: coffee.merchantId, earnRuleId: coffee.ruleIds[0], denomination: 5, floor: 10 });
    await mandate(inside, { perPurchaseMax: D('23.00'), expiresAt: new Date(Date.now() + 86_400_000) });
    const ok = await buy(inside);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ amountToPay: 23, outsideMandate: false });

    const tight = await db.shopper();
    await db.reward({ customerId: tight, merchantId: coffee.merchantId, earnRuleId: coffee.ruleIds[0], denomination: 5, floor: 10 });
    await mandate(tight, { perPurchaseMax: D('22.99'), expiresAt: new Date(Date.now() + 86_400_000) });
    const refused = await buy(tight);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: 'mandate_violation', details: { mandateCode: 'over_per_purchase_max' } });

    const approved = await buy(tight, { paymentMode: 'approval' });
    expect(approved.status).toBe(201);
    expect(approved.body).toMatchObject({ outsideMandate: true, paymentMode: 'approval' });
  });

  it('without limits set, the order still needs her PayPal approval and is not marked outside them', async () => {
    const customerId = await db.shopper();
    const res = await buy(customerId);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: CheckoutStatus.CREATED, paymentMode: 'approval', outsideMandate: false });
  });
});

describe('approve once (PayPal vault)', () => {
  const future = () => new Date(Date.now() + 86_400_000);
  const linked = (customerId: string, over: Partial<Prisma.MandateUncheckedCreateInput> = {}) =>
    mandate(customerId, { vaultStatus: 'ACTIVE', paypalPaymentTokenId: 'VAULT-tok-1', expiresAt: future(), ...over });
  const buy = (customerId: string, extra: Record<string, unknown> = {}) =>
    request(app).post('/api/v1/checkout/orders').set(as(customerId)).set('Idempotency-Key', randomUUID()).send({ productId: coffee.products.beans, ...extra });
  const withReward = async () => {
    const customerId = await db.shopper();
    await db.reward({ customerId, merchantId: coffee.merchantId, earnRuleId: coffee.ruleIds[0], denomination: 5, floor: 10 });
    return customerId;
  };

  it('pays inside the limits with the saved PayPal, with no approval step', async () => {
    const customerId = await withReward();
    await linked(customerId);

    const res = await buy(customerId);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: CheckoutStatus.COMPLETED, paymentMode: 'vault', amountToPay: 23, reward: { state: 'redeemed' }, earned: { state: 'issued' } });
    const [input] = holder.fake.callsTo('createOrder')[0].args as [{ payment: unknown }];
    expect(input.payment).toEqual({ kind: 'vault', vaultId: 'VAULT-tok-1' });
    expect(holder.fake.callsTo('captureOrder')).toHaveLength(0);
  });

  it('never uses the saved PayPal outside the limits: refused, or a normal approval if the shopper agrees', async () => {
    const customerId = await withReward();
    await linked(customerId, { perPurchaseMax: D('22.99') });

    expect((await buy(customerId)).status).toBe(403);
    const approved = await buy(customerId, { paymentMode: 'approval' });
    expect(approved.body).toMatchObject({ status: CheckoutStatus.CREATED, paymentMode: 'approval', outsideMandate: true });
    const inputs = holder.fake.callsTo('createOrder').map((c) => (c.args[0] as { payment: { kind: string } }).payment.kind);
    expect(inputs).toEqual(['approval']);
  });

  it('only pays without approval once linking PayPal is confirmed', async () => {
    const customerId = await withReward();
    await mandate(customerId, { vaultStatus: 'PENDING_APPROVAL', paypalSetupTokenId: `SETUP-${randomUUID()}`, expiresAt: future() });

    const res = await buy(customerId);
    expect(res.body).toMatchObject({ status: CheckoutStatus.CREATED, paymentMode: 'approval' });
  });

  it('revoking the limits stops payments without approval', async () => {
    const customerId = await withReward();
    const m = await linked(customerId);
    await request(app).post(`/api/v1/mandates/${m.id}/revoke`).set(as(customerId));

    const res = await buy(customerId);
    expect(res.body).toMatchObject({ status: CheckoutStatus.CREATED, paymentMode: 'approval' });
  });

  it("links PayPal once: setup returns PayPal's approval page, confirm saves the payment method", async () => {
    const customerId = await db.shopper();
    const created = await request(app).post('/api/v1/mandates').set(as(customerId))
      .send({ perPurchaseMax: 30, monthlyCap: 100, allowedMerchantIds: [coffee.merchantId], expiresInDays: 30 });

    const setup = await request(app).post(`/api/v1/mandates/${created.body.id}/vault/setup`).set(as(customerId));
    expect(setup.status).toBe(200);
    expect(setup.body.approvalUrl).toContain('sandbox.paypal.com');
    expect(setup.body.mandate.vault).toEqual({ status: 'PENDING_APPROVAL' });
    const [input] = holder.fake.callsTo('createSetupToken')[0].args as [{ returnUrl: string; cancelUrl: string }];
    expect(input.returnUrl).toContain(`/mandate/vault/return?mandate=${created.body.id}`);

    const confirmed = await request(app).post(`/api/v1/mandates/${created.body.id}/vault/confirm`).set(as(customerId));
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.vault).toEqual({ status: 'ACTIVE' });
    expect((await prisma.mandate.findUniqueOrThrow({ where: { id: created.body.id } })).paypalPaymentTokenId).toMatch(/^VAULT-SETUP-/);
  });

  it("can't be linked for someone else's limits, or confirmed before PayPal was asked", async () => {
    const owner = await db.shopper();
    const other = await db.shopper();
    const created = await request(app).post('/api/v1/mandates').set(as(owner))
      .send({ perPurchaseMax: 30, monthlyCap: 100, allowedMerchantIds: [coffee.merchantId], expiresInDays: 30 });

    expect((await request(app).post(`/api/v1/mandates/${created.body.id}/vault/setup`).set(as(other))).status).toBe(404);
    const early = await request(app).post(`/api/v1/mandates/${created.body.id}/vault/confirm`).set(as(owner));
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('vault_not_started');
  });
});
