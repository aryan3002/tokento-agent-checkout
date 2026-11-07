// ============================================================
// Tokento — Internal: the shopper server's shared spend guard
// ============================================================
// Only the shopper app's server calls these, with AGENT_USAGE_KEY (a secret both
// sides hold). Without that key configured the routes don't exist (404), so a
// shopper's own session can never charge or reset the demo's budget.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import redis from '../db/redis';
import { AgentUsageService, readAgentUsageLimits } from '../agent-usage/agent-usage.service';
import { AppError } from '../middleware/error.middleware';

const router = Router();

function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

router.use((req: Request, _res: Response, next: NextFunction) => {
  const expected = process.env.AGENT_USAGE_KEY ?? '';
  if (expected.length < 32) return next(new AppError(404, 'not_found', 'Not found.'));
  const given = req.header('x-agent-usage-key') ?? '';
  if (!sameKey(given, expected)) return next(new AppError(401, 'invalid_usage_key', 'A valid X-Agent-Usage-Key header is required.'));
  next();
});

const service = () => new AgentUsageService(redis, readAgentUsageLimits(process.env), Date.now, process.env.AGENT_USAGE_PREFIX || 'agent-usage');

const AdmitBody = z.object({ customerId: z.string().uuid() });
const ChargeBody = z.object({ costUsd: z.number() });

router.post('/admit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = AdmitBody.safeParse(req.body);
    if (!body.success) throw new AppError(400, 'invalid_request', 'Send { customerId } (a UUID).');
    res.json(await service().admit(body.data.customerId));
  } catch (err) { next(err); }
});

router.post('/charge', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = ChargeBody.safeParse(req.body);
    if (!body.success) throw new AppError(400, 'invalid_request', 'Send { costUsd } (a number).');
    res.json(await service().charge(body.data.costUsd));
  } catch (err) { next(err); }
});

export default router;
