// ============================================================
// Tokento — Catalog routes (demo product feed)
// ============================================================
import { Router, Request, Response, NextFunction } from 'express';
import { CatalogSearchSchema } from '@tokento/shared';
import { searchProducts } from '../checkout/catalog.service';
import { authenticateBearerToken } from '../middleware/auth.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { requireSandboxContext } from '../middleware/sandbox.middleware';

const router = Router();

// GET /v1/catalog/search?q=&category=&maxPrice=&limit=
router.get('/search', authenticateBearerToken(), rateLimit('QUERY'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = CatalogSearchSchema.parse(req.query);
    res.json({ products: await searchProducts(params, requireSandboxContext(req)) });
  } catch (err) { next(err); }
});

export default router;
