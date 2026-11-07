// The shopping agent's shared spend guard: counters in Redis, so every shopper
// server instance sees the same daily budget and per-shopper hourly limit.
// Real Redis (CI has it), each test under its own key prefix.
import '../src/config/env';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import redis from '../src/db/redis';
import { AgentUsageService } from '../src/agent-usage/agent-usage.service';
import agentUsageRoutes from '../src/routes/agent-usage.routes';
import { errorHandler } from '../src/middleware/error.middleware';

const prefixes: string[] = [];
function service(limits = { dailyBudgetUsd: 1, turnsPerHour: 3 }, at = '2026-11-07T15:00:00Z') {
  const prefix = `agent-usage-test:${randomUUID()}`;
  prefixes.push(prefix);
  let now = new Date(at).getTime();
  const svc = new AgentUsageService(redis, limits, () => now, prefix);
  return { svc, setNow: (iso: string) => { now = new Date(iso).getTime(); } };
}

afterAll(async () => {
  for (const prefix of prefixes) {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
  }
  await redis.quit();
});

describe('AgentUsageService', () => {
  it('lets a shopper send up to the hourly limit, then asks them to wait, without affecting others', async () => {
    const { svc } = service();
    const maya = randomUUID();
    const sam = randomUUID();
    expect(await svc.admit(maya)).toEqual({ ok: true });
    expect(await svc.admit(maya)).toEqual({ ok: true });
    expect(await svc.admit(maya)).toEqual({ ok: true });
    expect(await svc.admit(maya)).toEqual({ ok: false, code: 'hourly_limit', message: expect.stringMatching(/last hour/) });
    expect(await svc.admit(sam)).toEqual({ ok: true });
  });

  it('opens a new hour for the shopper', async () => {
    const { svc, setNow } = service({ dailyBudgetUsd: 1, turnsPerHour: 1 });
    const maya = randomUUID();
    expect((await svc.admit(maya)).ok).toBe(true);
    expect((await svc.admit(maya)).ok).toBe(false);
    setNow('2026-11-07T16:00:01Z');
    expect((await svc.admit(maya)).ok).toBe(true);
  });

  it('adds every model call to one daily total and stops everyone once the budget is spent', async () => {
    const { svc } = service({ dailyBudgetUsd: 1, turnsPerHour: 100 });
    expect(await svc.charge(0.4)).toEqual({ spentTodayUsd: 0.4, overBudget: false });
    expect(await svc.charge(0.35)).toEqual({ spentTodayUsd: 0.75, overBudget: false });
    expect(await svc.charge(0.25)).toEqual({ spentTodayUsd: 1, overBudget: true });
    expect(await svc.admit(randomUUID())).toEqual({ ok: false, code: 'daily_budget', message: expect.stringMatching(/today/) });
  });

  it('starts each UTC day with nothing spent', async () => {
    const { svc, setNow } = service({ dailyBudgetUsd: 1, turnsPerHour: 100 });
    await svc.charge(1.2);
    expect((await svc.admit(randomUUID())).ok).toBe(false);
    setNow('2026-11-08T00:00:05Z');
    expect((await svc.admit(randomUUID())).ok).toBe(true);
    expect(await svc.charge(0.1)).toEqual({ spentTodayUsd: 0.1, overBudget: false });
  });

  it('refuses costs that cannot come from one model call', async () => {
    const { svc } = service();
    for (const bad of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, 50]) {
      await expect(svc.charge(bad)).rejects.toMatchObject({ statusCode: 400, code: 'invalid_cost' });
    }
  });
});

describe('internal agent usage routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/internal/agent-usage', agentUsageRoutes);
  app.use(errorHandler());
  const KEY = 'k'.repeat(40);
  const saved = { key: process.env.AGENT_USAGE_KEY, prefix: process.env.AGENT_USAGE_PREFIX };

  afterEach(() => {
    process.env.AGENT_USAGE_KEY = saved.key;
    process.env.AGENT_USAGE_PREFIX = saved.prefix;
    if (saved.key === undefined) delete process.env.AGENT_USAGE_KEY;
    if (saved.prefix === undefined) delete process.env.AGENT_USAGE_PREFIX;
  });

  function enable() {
    process.env.AGENT_USAGE_KEY = KEY;
    process.env.AGENT_USAGE_PREFIX = `agent-usage-test:${randomUUID()}`;
    prefixes.push(process.env.AGENT_USAGE_PREFIX);
  }

  it('do not exist unless the server has a usage key', async () => {
    delete process.env.AGENT_USAGE_KEY;
    const res = await request(app).post('/api/v1/internal/agent-usage/admit').send({ customerId: randomUUID() });
    expect(res.status).toBe(404);
  });

  it('refuse callers without the right key', async () => {
    enable();
    const missing = await request(app).post('/api/v1/internal/agent-usage/admit').send({ customerId: randomUUID() });
    const wrong = await request(app).post('/api/v1/internal/agent-usage/charge').set('X-Agent-Usage-Key', 'x'.repeat(40)).send({ costUsd: 0.01 });
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  it('admit and charge for the shopper server', async () => {
    enable();
    const admit = await request(app).post('/api/v1/internal/agent-usage/admit').set('X-Agent-Usage-Key', KEY).send({ customerId: randomUUID() });
    expect(admit.status).toBe(200);
    expect(admit.body).toEqual({ ok: true });
    const charge = await request(app).post('/api/v1/internal/agent-usage/charge').set('X-Agent-Usage-Key', KEY).send({ costUsd: 0.05 });
    expect(charge.status).toBe(200);
    expect(charge.body).toEqual({ spentTodayUsd: 0.05, overBudget: false });
  });

  it('validate what the shopper server sends', async () => {
    enable();
    const res = await request(app).post('/api/v1/internal/agent-usage/admit').set('X-Agent-Usage-Key', KEY).send({ customerId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });
});
