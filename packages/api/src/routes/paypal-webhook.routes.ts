// ============================================================
// Tokento — PayPal webhook route
// ============================================================
// No API key: PayPal can't send one. Every event is verified with PayPal
// (verify-webhook-signature against PAYPAL_WEBHOOK_ID) before it is used.
import { Router, Request, Response, NextFunction } from 'express';
import { receivePayPalWebhook } from '../checkout/webhook-handler';

const router = Router();

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await receivePayPalWebhook({ headers: req.headers, body: req.body });
    res.status(result.httpStatus).json(result.body);
  } catch (err) {
    next(err);
  }
});

export default router;
