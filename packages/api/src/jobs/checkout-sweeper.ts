// ============================================================
// Tokento — Checkout sweeper
// ============================================================
// A reward held by an order nobody finishes would be locked forever. Every few
// minutes this looks at orders older than the hold window (30 minutes) and asks
// PayPal what happened: approved but never captured → capture it; already
// captured → finish it; otherwise → cancel the order and release the reward.
import { captureOf, PayPalApiError } from '@tokento/paypal';
import { CheckoutStatus } from '@tokento/shared';
import prisma from '../db/client';
import redis from '../db/redis';
import { checkoutService } from '../checkout/checkout.service';
import { finalizeCapture } from '../checkout/finalize';
import { getPayPal } from '../checkout/paypal';
import { logger } from '../utils/logger';

const LOCK_KEY = 'jobs:checkout-sweeper:lock';
const BATCH = 50;

export interface CheckoutSweepResult {
  captured: number;
  expired: number;
  skipped: boolean;
}

function holdMinutes(): number {
  const value = Number(process.env.CHECKOUT_HOLD_MINUTES);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

/** `merchantIds` limits a run to some stores (manual runs and tests). */
export async function sweepCheckouts(opts: { now?: Date; merchantIds?: string[] } = {}): Promise<CheckoutSweepResult> {
  const result: CheckoutSweepResult = { captured: 0, expired: 0, skipped: false };
  let locked = false;
  try {
    locked = (await redis.set(LOCK_KEY, String(process.pid), 'EX', 240, 'NX')) === 'OK';
  } catch (err) {
    logger.warn({ err }, 'Checkout sweeper: lock unavailable, skipping tick');
  }
  if (!locked) return { ...result, skipped: true };

  try {
    const cutoff = new Date((opts.now ?? new Date()).getTime() - holdMinutes() * 60_000);
    const stale = await prisma.checkoutOrder.findMany({
      where: {
        status: { in: [CheckoutStatus.PENDING, CheckoutStatus.CREATED, CheckoutStatus.APPROVED, CheckoutStatus.CAPTURED] },
        createdAt: { lt: cutoff },
        ...(opts.merchantIds ? { merchantId: { in: opts.merchantIds } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    });

    for (const order of stale) {
      try {
        if (order.status === CheckoutStatus.CAPTURED) {
          await checkoutService.capture(order.id, { kind: 'system', source: 'sweeper' });
          result.captured += 1;
          continue;
        }
        if (order.status === CheckoutStatus.PENDING || !order.paypalOrderId) {
          if (await checkoutService.expire(order.id, 'Could not open a PayPal order in time. Nothing was charged.')) result.expired += 1;
          continue;
        }

        const ppOrder = await getPayPal().getOrder(order.paypalOrderId);
        if (ppOrder.status === 'APPROVED') {
          await checkoutService.capture(order.id, { kind: 'system', source: 'sweeper' });
          result.captured += 1;
        } else if (ppOrder.status === 'COMPLETED' && captureOf(ppOrder)) {
          const cap = captureOf(ppOrder)!;
          await finalizeCapture(order.id, { captureId: cap.id, status: cap.status, amount: cap.amount.value, currency: cap.amount.currency_code }, 'sweeper');
          result.captured += 1;
        } else if (await checkoutService.expire(order.id, `Expired: the payment wasn't approved in PayPal within ${holdMinutes()} minutes. Nothing was charged.`)) {
          result.expired += 1;
        }
      } catch (err) {
        if (err instanceof PayPalApiError && err.status === 404) {
          if (await checkoutService.expire(order.id, 'PayPal no longer has this order. Nothing was charged.')) result.expired += 1;
        } else {
          logger.error({ err, checkoutId: order.id }, 'Checkout sweeper: could not settle a stale order; will retry next tick');
        }
      }
    }
    if (result.captured || result.expired) logger.info(result, 'Checkout sweeper ran');
    return result;
  } finally {
    await redis.del(LOCK_KEY).catch(() => {});
  }
}

export function startCheckoutSweeper(intervalMs = Number(process.env.CHECKOUT_SWEEP_INTERVAL_MS) || 300_000) {
  const timer = setInterval(() => { void sweepCheckouts(); }, intervalMs);
  timer.unref();
  logger.info({ intervalMs }, 'Checkout sweeper started');
  return timer;
}
