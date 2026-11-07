// Hosted demo: every visitor gets a fresh shopper and a signed demo session.
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CheckoutStatus } from '@tokento/shared';
import { DbFixtures, prisma, type StoreFixture } from './helpers/db-fixtures';
import { signDemoSession, verifyDemoSession } from '../src/demo/demo-session';
import { provisionDemoShopper } from '../src/demo/demo-shopper.service';
import demoRoutes from '../src/routes/demo.routes';
import mandateRoutes from '../src/routes/mandate.routes';
import checkoutRoutes from '../src/routes/checkout.routes';
import { errorHandler } from '../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v1/demo', demoRoutes);
app.use('/api/v1/mandates', mandateRoutes);
app.use('/api/v1/checkout', checkoutRoutes);
app.use(errorHandler());

const SECRET = 'test-demo-secret-0123456789abcdef0123456789';
const db = new DbFixtures();
let coffee: StoreFixture;
let ridgeline: StoreFixture;
const provisioned: string[] = [];

const template = () => ({
  rewards: [
    { merchantId: coffee.merchantId, earnRuleId: coffee.ruleIds[0], denomination: 5, minimumTransactionFloor: 10, expiryDays: 90 },
    { merchantId: ridgeline.merchantId, earnRuleId: ridgeline.ruleIds[0], denomination: 3, minimumTransactionFloor: 30, expiryDays: 60 },
  ],
  storeIds: [coffee.merchantId, ridgeline.merchantId],
});

beforeAll(async () => {
  coffee = await db.store('Coffee Co. (demo test)', {
    rules: [{ name: 'Spend $20, Get $5 Off', spendThreshold: 20, tokenDenomination: 5, minimumTransactionFloor: 10 }],
    products: [{ key: 'beans', name: `Demo beans ${randomUUID().slice(0, 6)}`, price: '28.00' }],
  });
  ridgeline = await db.store('Ridgeline (demo test)', {
    rules: [{ name: 'Spend $25, Get $2 Off', spendThreshold: 25, tokenDenomination: 2, minimumTransactionFloor: 0 }],
    products: [{ key: 'beans', name: `Ridgeline beans ${randomUUID().slice(0, 6)}`, price: '26.50' }],
  });
  vi.stubEnv('JWT_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('JWT_SECRET', SECRET);
});

afterAll(async () => {
  await prisma.checkoutOrder.deleteMany({ where: { customerId: { in: provisioned } } });
  await prisma.mandate.deleteMany({ where: { customerId: { in: provisioned } } });
  await prisma.token.deleteMany({ where: { customerId: { in: provisioned } } });
  await prisma.wallet.deleteMany({ where: { customerId: { in: provisioned } } });
  vi.unstubAllEnvs();
  await db.cleanup();
});

async function newDemoShopper() {
  const shopper = await provisionDemoShopper(template(), new Date());
  provisioned.push(shopper.customerId);
  return shopper;
}

describe('demo sessions', () => {
  it('verify only an untouched, unexpired token signed with the secret', () => {
    const customerId = randomUUID();
    const now = new Date('2026-11-10T12:00:00Z');
    const token = signDemoSession(customerId, new Date('2026-11-17T12:00:00Z'), SECRET);

    expect(token.startsWith('demo_session::')).toBe(true);
    expect(verifyDemoSession(token, SECRET, now)).toBe(customerId);
    expect(verifyDemoSession(token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'), SECRET, now)).toBeNull();
    expect(verifyDemoSession(token.replace(customerId, randomUUID()), SECRET, now)).toBeNull();
    expect(verifyDemoSession(token, 'another-secret-0123456789abcdef0123', now)).toBeNull();
    expect(verifyDemoSession(token, SECRET, new Date('2026-11-18T00:00:00Z'))).toBeNull();
  });
});

describe('demo shoppers', () => {
  it("start with Maya's two rewards and $30 / $100 spending limits on the demo stores", async () => {
    const shopper = await newDemoShopper();

    const tokens = await prisma.token.findMany({ where: { customerId: shopper.customerId, status: 'ACTIVE' } });
    expect(tokens.map((t) => Number(t.denomination)).sort()).toEqual([3, 5]);
    const mandate = await prisma.mandate.findFirstOrThrow({ where: { customerId: shopper.customerId } });
    expect(Number(mandate.perPurchaseMax)).toBe(30);
    expect(Number(mandate.monthlyCap)).toBe(100);
    expect(mandate.allowedMerchantIds.sort()).toEqual([coffee.merchantId, ridgeline.merchantId].sort());
  });

  it('get a session that works on shopper routes only while DEMO_MODE is on', async () => {
    const shopper = await newDemoShopper();
    const auth = { Authorization: `Bearer ${shopper.token}` };

    vi.stubEnv('DEMO_MODE', 'true');
    const on = await request(app).get('/api/v1/mandates/active').set(auth);
    expect(on.status).toBe(200);
    expect(on.body.mandate).toMatchObject({ perPurchaseMax: 30 });

    vi.stubEnv('DEMO_MODE', 'false');
    expect((await request(app).get('/api/v1/mandates/active').set(auth)).status).toBe(401);
  });

  it("can't read each other's orders", async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    const a = await newDemoShopper();
    const b = await newDemoShopper();
    const order = await prisma.checkoutOrder.create({
      data: {
        customerId: a.customerId, merchantId: coffee.merchantId, productId: coffee.products.beans,
        subtotal: 28, amountToPay: 23, status: CheckoutStatus.CREATED, idempotencyKey: randomUUID(),
      },
    });

    expect((await request(app).get(`/api/v1/checkout/orders/${order.id}`).set({ Authorization: `Bearer ${b.token}` })).status).toBe(403);
    expect((await request(app).get(`/api/v1/checkout/orders/${order.id}`).set({ Authorization: `Bearer ${a.token}` })).status).toBe(200);
  });
});

describe('POST /demo/shoppers', () => {
  it('does not exist unless DEMO_MODE is on', async () => {
    vi.stubEnv('DEMO_MODE', 'false');
    expect((await request(app).post('/api/v1/demo/shoppers')).status).toBe(404);
  });
});
