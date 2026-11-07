// ============================================================
// Tokento — Agent checkout routes (shopper session)
// ============================================================
// These sit beside the Token Query Interface, not inside it: quoting, paying
// with PayPal and the order lifecycle. Every amount is computed server-side.
import { Router, Request, Response, NextFunction } from 'express';
import { CreateCheckoutSchema, QuoteRequestSchema } from '@tokento/shared';
import { checkoutService } from '../checkout/checkout.service';
import { quoteService } from '../checkout/quote.service';
import { authenticateBearerToken } from '../middleware/auth.middleware';
import { AppError } from '../middleware/error.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { requireSandboxContext } from '../middleware/sandbox.middleware';

const router = Router();
router.use(authenticateBearerToken());

const param = (req: Request, name: string): string => {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] : value;
};

// POST /v1/checkout/quote — compare products across stores with the shopper's rewards
router.post('/quote', rateLimit('QUERY'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = QuoteRequestSchema.parse(req.body);
    res.json(await quoteService.quote(req.customerId!, input, requireSandboxContext(req)));
  } catch (err) { next(err); }
});

// POST /v1/checkout/orders — hold the reward and open a PayPal order
router.post('/orders', rateLimit('DEFAULT'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = CreateCheckoutSchema.parse(req.body);
    const header = req.headers['idempotency-key'];
    const idempotencyKey = (Array.isArray(header) ? header[0] : header) ?? body.idempotencyKey;
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new AppError(400, 'idempotency_key_required', 'Send an Idempotency-Key header (8-128 characters) so a retry cannot buy twice.');
    }
    const order = await checkoutService.create(req.customerId!, {
      productId: body.productId,
      quantity: body.quantity,
      useReward: body.useReward,
      paymentMode: body.paymentMode,
      agentReason: body.agentReason,
    }, { isSandbox: requireSandboxContext(req), idempotencyKey, agentId: body.agentId });
    res.status(201).json(order);
  } catch (err) { next(err); }
});

// GET /v1/checkout/orders — the shopper's orders, newest first
router.get('/orders', rateLimit('QUERY'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ orders: await checkoutService.listForCustomer(req.customerId!) });
  } catch (err) { next(err); }
});

router.get('/orders/:id', rateLimit('QUERY'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await checkoutService.get(param(req, 'id'), { kind: 'customer', customerId: req.customerId! }));
  } catch (err) { next(err); }
});

// POST /v1/checkout/orders/:id/capture — after the shopper approves in PayPal
router.post('/orders/:id/capture', rateLimit('DEFAULT'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await checkoutService.capture(param(req, 'id'), { kind: 'customer', customerId: req.customerId! }));
  } catch (err) { next(err); }
});

router.post('/orders/:id/cancel', rateLimit('DEFAULT'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await checkoutService.cancel(req.customerId!, param(req, 'id')));
  } catch (err) { next(err); }
});

export default router;
