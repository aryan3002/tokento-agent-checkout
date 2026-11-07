// ============================================================
// Tokento — Hosted demo: a fresh shopper per visitor (DEMO_MODE only)
// ============================================================
import { Router, Request, Response, NextFunction } from 'express';
import { demoModeOn } from '../demo/demo-session';
import { provisionDemoShopper } from '../demo/demo-shopper.service';

const router = Router();
// Visitors arrive through the shopper app's server, so this is per server more than per person.
const PER_HOUR = 60;
const recent = new Map<string, number[]>();

// POST /v1/demo/shoppers — 60 per hour per IP
router.post('/shoppers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!demoModeOn()) {
      res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
      return;
    }
    const ip = req.ip ?? 'unknown';
    const since = Date.now() - 3600_000;
    const hits = (recent.get(ip) ?? []).filter((t) => t > since);
    if (hits.length >= PER_HOUR) {
      res.status(429).json({ error: { code: 'rate_limited', message: 'Too many demo shoppers from this address. Try again later.' } });
      return;
    }
    recent.set(ip, [...hits, Date.now()]);
    res.status(201).json(await provisionDemoShopper());
  } catch (err) { next(err); }
});

export default router;
