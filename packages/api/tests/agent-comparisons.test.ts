// How often shopping agents pick a store: the win/lose rules for one comparison,
// recording them from real quotes (real Postgres), and the store's counts over HTTP.
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { EventType, type OfferView } from '@tokento/shared';
// Fixtures first: they load .env before the Prisma client is created.
import { DbFixtures, prisma } from './helpers/db-fixtures';
import { comparisonOutcomes } from '../src/checkout/comparison-outcomes';
import { quoteService } from '../src/checkout/quote.service';
import { eventBus } from '../src/events/emitter';
import merchantRoutes from '../src/routes/merchant.routes';
import eventsRoutes from '../src/routes/events.routes';
import { errorHandler } from '../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v1/merchants', merchantRoutes);
app.use('/api/v1/events', eventsRoutes);
app.use(errorHandler());

const db = new DbFixtures();

afterAll(async () => {
  await db.cleanup();
});

/** Three stores selling the same beans, and a shopper with a $5 Coffee Co. reward. */
async function threeStores(label: string) {
  const coffeeStore = await db.store(`Coffee Co. (${label})`, {
    rules: [{ name: 'Spend $20, Get $5 Off', spendThreshold: 20, tokenDenomination: 5, minimumTransactionFloor: 10 }],
    products: [
      { key: 'beans', name: 'Morning Ridge Blend, medium roast, whole bean, 2 lb', price: '28.00' },
      { key: 'filters', name: 'Paper filters #4, 100 pack', price: '6.00', category: 'supplies' },
    ],
  });
  const ridgelineStore = await db.store(`Ridgeline Roasters (${label})`, {
    rules: [{ name: 'Spend $25, Get $2 Off', spendThreshold: 25, tokenDenomination: 2 }],
    products: [{ key: 'beans', name: 'Summit Medium Roast, whole bean, 2 lb', price: '26.50' }],
  });
  const harborStore = await db.store(`Harbor Bean Supply (${label})`, {
    products: [{ key: 'beans', name: 'Harbor House Medium Roast, whole bean, 2 lb', price: '25.00' }],
  });
  const customerId = await db.shopper();
  await db.reward({ customerId, merchantId: coffeeStore.merchantId, earnRuleId: coffeeStore.ruleIds[0], denomination: 5, floor: 10 });
  return {
    coffee: coffeeStore,
    ridgeline: ridgelineStore,
    harbor: harborStore,
    customerId,
    merchantIds: [coffeeStore.merchantId, ridgelineStore.merchantId, harborStore.merchantId],
    beans: [coffeeStore.products.beans, ridgelineStore.products.beans, harborStore.products.beans],
  };
}

function comparedEvents(): Array<Record<string, unknown>> {
  const seen: Array<Record<string, unknown>> = [];
  const listener = (payload: Record<string, unknown>) => seen.push(payload);
  eventBus.on(EventType.AGENT_COMPARED, listener);
  afterEachCleanups.push(() => eventBus.off(EventType.AGENT_COMPARED, listener));
  return seen;
}
const afterEachCleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of afterEachCleanups.splice(0)) cleanup();
});

function offer(o: { merchantId: string; productId: string; subtotal: number; effectiveCost: number }): OfferView {
  return {
    productId: o.productId,
    productName: o.productId,
    sku: o.productId,
    merchantId: o.merchantId,
    merchantName: o.merchantId,
    unitPrice: o.subtotal,
    quantity: 1,
    subtotal: o.subtotal,
    reward: null,
    amountToPay: o.subtotal,
    earn: null,
    effectiveCost: o.effectiveCost,
    withinBudget: null,
    mandate: { within: true },
    reason: '',
  };
}

// Offers arrive best total value first, as the quote ranks them.
const coffee = offer({ merchantId: 'coffee', productId: 'coffee-beans', subtotal: 28, effectiveCost: 18 });
const ridgeline = offer({ merchantId: 'ridgeline', productId: 'ridgeline-beans', subtotal: 26.5, effectiveCost: 24.5 });
const harbor = offer({ merchantId: 'harbor', productId: 'harbor-beans', subtotal: 25, effectiveCost: 25 });

describe('comparison outcomes', () => {
  it('credits the rewards when the recommended store was not the cheapest on sticker price', () => {
    expect(comparisonOutcomes([coffee, ridgeline, harbor], 'coffee-beans')).toEqual([
      { merchantId: 'coffee', productId: 'coffee-beans', subtotal: 28, effectiveCost: 18, outcome: 'won_with_rewards' },
      { merchantId: 'ridgeline', productId: 'ridgeline-beans', subtotal: 26.5, effectiveCost: 24.5, outcome: 'not_chosen' },
      { merchantId: 'harbor', productId: 'harbor-beans', subtotal: 25, effectiveCost: 25, outcome: 'not_chosen' },
    ]);
  });

  it('calls it a win on price when no other store had a lower sticker price', () => {
    const cheapHarbor = offer({ merchantId: 'harbor', productId: 'harbor-beans', subtotal: 17, effectiveCost: 17 });
    expect(comparisonOutcomes([cheapHarbor, coffee], 'harbor-beans').map((o) => [o.merchantId, o.outcome])).toEqual([
      ['harbor', 'won_on_price'],
      ['coffee', 'not_chosen'],
    ]);
  });

  it('treats an equal sticker price as a win on price, not a reward win', () => {
    const harborAt28 = offer({ merchantId: 'harbor', productId: 'harbor-beans', subtotal: 28, effectiveCost: 28 });
    expect(comparisonOutcomes([coffee, harborAt28], 'coffee-beans').map((o) => o.outcome)).toEqual(['won_on_price', 'not_chosen']);
  });

  it('records nothing when every offer came from one store', () => {
    const filters = offer({ merchantId: 'coffee', productId: 'coffee-filters', subtotal: 6, effectiveCost: 6 });
    expect(comparisonOutcomes([filters, coffee], 'coffee-filters')).toEqual([]);
  });

  it('gives each store one line, for its best offer', () => {
    const decaf = offer({ merchantId: 'coffee', productId: 'coffee-decaf', subtotal: 30, effectiveCost: 24 });
    expect(comparisonOutcomes([coffee, decaf, harbor], 'coffee-beans').map((o) => [o.merchantId, o.productId, o.outcome])).toEqual([
      ['coffee', 'coffee-beans', 'won_with_rewards'],
      ['harbor', 'harbor-beans', 'not_chosen'],
    ]);
  });

  it('marks every store not chosen when nothing fit the budget', () => {
    expect(comparisonOutcomes([coffee, harbor], null).map((o) => o.outcome)).toEqual(['not_chosen', 'not_chosen']);
  });
});

describe('recording agent comparisons from quotes', () => {
  it('saves one line per store under one comparison id, with Coffee Co. winning on its rewards', async () => {
    const t = await threeStores('records');
    await quoteService.quote(t.customerId, { productIds: t.beans }, true);

    const rows = await prisma.agentComparison.findMany({ where: { merchantId: { in: t.merchantIds } } });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.comparisonId)).size).toBe(1);
    const byStore = Object.fromEntries(rows.map((r) => [r.merchantId, r]));
    expect(byStore[t.coffee.merchantId]).toMatchObject({ productId: t.coffee.products.beans, outcome: 'won_with_rewards', storesCompared: 3, quantity: 1, isSandbox: true });
    expect(Number(byStore[t.coffee.merchantId].subtotal)).toBe(28);
    expect(Number(byStore[t.coffee.merchantId].effectiveCost)).toBe(18);
    expect(byStore[t.ridgeline.merchantId].outcome).toBe('not_chosen');
    expect(byStore[t.harbor.merchantId].outcome).toBe('not_chosen');
  });

  it('saves nothing when the agent compared products from one store only', async () => {
    const t = await threeStores('one store');
    await quoteService.quote(t.customerId, { productIds: [t.coffee.products.beans, t.coffee.products.filters] }, true);
    expect(await prisma.agentComparison.count({ where: { merchantId: { in: t.merchantIds } } })).toBe(0);
  });

  it('tells each store live, with only its own outcome', async () => {
    const t = await threeStores('live');
    const events = comparedEvents();
    await quoteService.quote(t.customerId, { productIds: t.beans }, true);

    expect(events.map((e) => [e.merchantId, e.outcome])).toEqual([
      [t.coffee.merchantId, 'won_with_rewards'],
      [t.ridgeline.merchantId, 'not_chosen'],
      [t.harbor.merchantId, 'not_chosen'],
    ]);
    expect(events.every((e) => Object.keys(e).sort().join() === 'comparisonId,merchantId,outcome,timestamp,type')).toBe(true);
  });

  it('still answers the quote, and announces nothing, when saving the comparison fails', async () => {
    const t = await threeStores('save fails');
    const events = comparedEvents();
    // Prisma's model methods don't survive vi.spyOn's restore, so swap one in by hand.
    const delegate = prisma.agentComparison;
    const realCreateMany = delegate.createMany;
    delegate.createMany = (() => Promise.reject(new Error('database unavailable'))) as unknown as typeof realCreateMany;
    let quote;
    try {
      quote = await quoteService.quote(t.customerId, { productIds: t.beans }, true);
    } finally {
      delegate.createMany = realCreateMany;
    }

    expect(quote.recommendedProductId).toBe(t.coffee.products.beans);
    expect(quote.offers).toHaveLength(3);
    expect(events).toEqual([]);
    expect(await prisma.agentComparison.count({ where: { merchantId: { in: t.merchantIds } } })).toBe(0);
  });
});

describe("a store's agent comparison numbers", () => {
  const stats = (apiKey: string) => request(app).get('/api/v1/merchants/me/agent-comparisons').set('X-API-Key', apiKey);

  it('shows a store how the last agent comparison went for it', async () => {
    const t = await threeStores('stats');
    await quoteService.quote(t.customerId, { productIds: t.beans }, true);

    const coffeeStats = await stats(await db.apiKey(t.coffee.merchantId));
    expect(coffeeStats.status).toBe(200);
    expect(coffeeStats.body).toEqual({ comparisons: 1, recommended: 1, wonWithRewards: 1, wonOnPrice: 0, notChosen: 0, lastComparedAt: expect.any(String) });

    const harborStats = await stats(await db.apiKey(t.harbor.merchantId));
    expect(harborStats.body).toEqual({ comparisons: 1, recommended: 0, wonWithRewards: 0, wonOnPrice: 0, notChosen: 1, lastComparedAt: expect.any(String) });
  });

  it('counts each outcome for this store and this environment only', async () => {
    const mine = await db.store('Counted store', { products: [{ key: 'beans', name: 'Beans', price: '20.00' }] });
    const other = await db.store('Other store', { products: [{ key: 'beans', name: 'Beans', price: '19.00' }] });
    const line = (store: typeof mine, outcome: string, createdAt: string, isSandbox = true) => ({
      comparisonId: randomUUID(),
      merchantId: store.merchantId,
      productId: store.products.beans,
      outcome,
      quantity: 1,
      subtotal: 20,
      effectiveCost: 15,
      storesCompared: 2,
      isSandbox,
      createdAt: new Date(createdAt),
    });
    await prisma.agentComparison.createMany({
      data: [
        line(mine, 'won_with_rewards', '2026-11-01T10:00:00Z'),
        line(mine, 'won_with_rewards', '2026-11-02T10:00:00Z'),
        line(mine, 'won_on_price', '2026-11-03T10:00:00Z'),
        line(mine, 'not_chosen', '2026-11-04T10:00:00Z'),
        line(mine, 'not_chosen', '2026-11-04T11:00:00Z'),
        line(mine, 'not_chosen', '2026-11-05T10:00:00Z'),
        line(mine, 'won_on_price', '2026-11-06T10:00:00Z', false),
        line(other, 'won_with_rewards', '2026-11-06T12:00:00Z'),
      ],
    });

    const res = await stats(await db.apiKey(mine.merchantId));
    expect(res.body).toEqual({ comparisons: 6, recommended: 3, wonWithRewards: 2, wonOnPrice: 1, notChosen: 3, lastComparedAt: '2026-11-05T10:00:00.000Z' });
  });

  it('shows zeros to a store no agent has compared yet', async () => {
    const fresh = await db.store('Brand new store', { products: [{ key: 'beans', name: 'Beans', price: '20.00' }] });
    const res = await stats(await db.apiKey(fresh.merchantId));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ comparisons: 0, recommended: 0, wonWithRewards: 0, wonOnPrice: 0, notChosen: 0, lastComparedAt: null });
  });

  it("needs the store's own credentials", async () => {
    const res = await request(app).get('/api/v1/merchants/me/agent-comparisons');
    expect(res.status).toBe(401);
  });
});

describe("live updates on a store's event stream", () => {
  /** A real SSE connection, parsed into events as they arrive. */
  function openStream(baseUrl: string, apiKey: string) {
    const received: Array<{ event: string; data: Record<string, unknown> }> = [];
    let buffer = '';
    const req = http.get(`${baseUrl}/api/v1/events/stream?apiKey=${encodeURIComponent(apiKey)}`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event && data) received.push({ event, data: JSON.parse(data) });
        }
      });
    });
    req.on('error', () => {});
    return { received, close: () => req.destroy() };
  }

  it("sends each store its own comparison outcome and nothing about the others", async () => {
    const t = await threeStores('stream');
    const server = app.listen(0);
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const coffeeStream = openStream(baseUrl, await db.apiKey(t.coffee.merchantId));
    const harborStream = openStream(baseUrl, await db.apiKey(t.harbor.merchantId));
    try {
      await vi.waitFor(() => {
        expect(coffeeStream.received.some((e) => e.event === 'ready')).toBe(true);
        expect(harborStream.received.some((e) => e.event === 'ready')).toBe(true);
      });

      await quoteService.quote(t.customerId, { productIds: t.beans }, true);

      const compared = (stream: ReturnType<typeof openStream>) => stream.received.filter((e) => e.event === 'agent.compared').map((e) => [e.data.merchantId, e.data.outcome]);
      await vi.waitFor(() => {
        expect(compared(coffeeStream)).toEqual([[t.coffee.merchantId, 'won_with_rewards']]);
        expect(compared(harborStream)).toEqual([[t.harbor.merchantId, 'not_chosen']]);
      });
    } finally {
      coffeeStream.close();
      harborStream.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
