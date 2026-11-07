// ============================================================
// Tokento — Spending-limit routes (shopper session only)
// ============================================================
// Agents can read limits through the shopper's session but no agent tool calls
// these write routes; the shopper sets and revokes limits in the app.
import { Router, Request, Response, NextFunction } from 'express';
import { CreateMandateSchema } from '@tokento/shared';
import { mandateService } from '../mandates/mandate.service';
import { authenticateBearerToken } from '../middleware/auth.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { requireSandboxContext } from '../middleware/sandbox.middleware';

const router = Router();
router.use(authenticateBearerToken());

const param = (req: Request, name: string): string => {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] : value;
};

// GET /v1/mandates/active — the shopper's current limits, or null
router.get('/active', rateLimit('QUERY'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mandate = await mandateService.active(req.customerId!);
    res.json({ mandate: mandate ? await mandateService.view(mandate) : null });
  } catch (err) { next(err); }
});

// POST /v1/mandates — set new limits (replaces any active ones)
router.post('/', rateLimit('DEFAULT'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = CreateMandateSchema.parse(req.body);
    res.status(201).json(await mandateService.create(req.customerId!, input, requireSandboxContext(req)));
  } catch (err) { next(err); }
});

// POST /v1/mandates/:id/revoke
router.post('/:id/revoke', rateLimit('DEFAULT'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await mandateService.revoke(req.customerId!, param(req, 'id')));
  } catch (err) { next(err); }
});

export default router;
