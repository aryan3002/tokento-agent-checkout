// ============================================================
// Tokento — Finalize a captured payment
// ============================================================
// Runs once PayPal has the money, from whichever signal arrives first: the
// capture response, the verified webhook, or the sweeper. Under the per-order
// lock it checks the captured amount, redeems the held reward, issues the earned
// reward and records the platform fee. Every step is idempotent, so a crash
// part-way through is finished by the next signal.
import { Prisma } from '@prisma/client';
import { CheckoutStatus, EventType, type CheckoutOrderView } from '@tokento/shared';
import type { CheckoutOrder } from '@prisma/client';
import prisma from '../db/client';
import { emitEvent } from '../events/emitter';
import { AppError } from '../middleware/error.middleware';
import { redemptionService } from '../services/redemption.service';
import { tokenService } from '../services/token.service';
import { logger } from '../utils/logger';
import { toMoneyNumber } from '../utils/money';
import { invalidateWalletCache } from '../utils/wallet-cache';
import { withOrderLock } from './order-lock';
import { loadOrderView } from './views';

export interface CaptureInfo {
  captureId: string;
  /** PayPal capture status: COMPLETED, PENDING, DECLINED, FAILED... */
  status: string;
  /** Two-decimal string as PayPal reports it. */
  amount: string;
  currency: string;
}

export type FinalizeSource = 'capture_response' | 'webhook' | 'sweeper';

export type AfterCommit = Array<() => void>;

const FINISHED: string[] = [CheckoutStatus.COMPLETED, CheckoutStatus.REFUNDED, CheckoutStatus.REFUND_PENDING, CheckoutStatus.NEEDS_REVIEW];
const CLOSED_UNPAID: string[] = [CheckoutStatus.CANCELLED, CheckoutStatus.FAILED];

/** Platform fee on the amount paid, PLATFORM_FEE_BPS basis points (default 200 = 2%), half-up to the cent. */
export function platformFeeFor(amountPaid: Prisma.Decimal): Prisma.Decimal {
  const raw = Number.parseInt(process.env.PLATFORM_FEE_BPS ?? '200', 10);
  const bps = Number.isInteger(raw) && raw >= 0 && raw <= 10_000 ? raw : 200;
  return amountPaid.times(bps).dividedBy(10_000).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function statusEvent(order: CheckoutOrder, status: string): () => void {
  return () => emitEvent(EventType.CHECKOUT_UPDATED, {
    checkoutId: order.id,
    merchantId: order.merchantId,
    customerId: order.customerId,
    status,
  });
}

function parseAmount(value: string): Prisma.Decimal | null {
  try {
    return new Prisma.Decimal(value);
  } catch {
    return null;
  }
}

async function redeemHeldReward(order: CheckoutOrder): Promise<{ ok: true; redemptionId: string; settlementRef: string } | { ok: false; reason: string }> {
  const tokenId = order.rewardTokenId!;
  try {
    const result = await redemptionService.redeem(tokenId, {
      transactionAmount: toMoneyNumber(order.subtotal),
      merchantId: order.merchantId,
      agentId: order.agentId ?? undefined,
      idempotencyKey: `checkout:${order.id}`,
    }, {
      isSandbox: order.isSandbox,
      authenticatedCustomerId: order.customerId,
      checkoutOrderId: order.id,
      asOf: order.createdAt,
    });
    return { ok: true, redemptionId: result.redemptionId, settlementRef: result.settlementReference };
  } catch (err) {
    // A previous attempt may have redeemed it before crashing.
    const existing = await prisma.redemption.findUnique({ where: { tokenId } });
    if (existing && existing.customerId === order.customerId) {
      return { ok: true, redemptionId: existing.id, settlementRef: existing.settlementRef };
    }
    const reason = err instanceof AppError ? err.message : (err as Error).message;
    logger.error({ err, checkoutId: order.id, tokenId }, 'Held reward could not be redeemed after capture');
    return { ok: false, reason };
  }
}

async function issueEarnedReward(order: CheckoutOrder): Promise<{ tokenId: string | null; note?: string }> {
  const idempotencyKey = `earn:${order.id}`;
  try {
    const minted = await tokenService.mint({
      merchantId: order.merchantId,
      customerId: order.customerId,
      transactionAmount: toMoneyNumber(order.amountToPay),
      earnRuleId: order.earnRuleId!,
      idempotencyKey,
    }, order.isSandbox);
    return { tokenId: minted.token.id };
  } catch (err) {
    const existing = await prisma.token.findUnique({
      where: { idempotencyKey_merchantId: { idempotencyKey, merchantId: order.merchantId } },
    });
    if (existing) return { tokenId: existing.id };
    const reason = err instanceof AppError ? err.message : (err as Error).message;
    logger.error({ err, checkoutId: order.id }, 'Earn rule could not issue a reward after capture');
    return { tokenId: null, note: `Paid, but the store's earn rule could not issue a reward (${reason}).` };
  }
}

/**
 * The finalize steps. Must run inside withOrderLock with its transaction client;
 * returns work to run after the transaction commits (events, cache).
 */
export async function finalizeLocked(
  tx: Prisma.TransactionClient,
  checkoutId: string,
  capture: CaptureInfo,
  source: FinalizeSource,
): Promise<AfterCommit> {
  const order = await tx.checkoutOrder.findUnique({ where: { id: checkoutId } });
  if (!order) throw new AppError(404, 'checkout_not_found', 'Checkout order not found.');
  const after: AfterCommit = [];
  if (FINISHED.includes(order.status)) return after;

  if (capture.status !== 'COMPLETED') {
    if (capture.status === 'PENDING') {
      if (order.status !== CheckoutStatus.CAPTURE_PENDING) {
        await tx.checkoutOrder.update({
          where: { id: order.id },
          data: { status: CheckoutStatus.CAPTURE_PENDING, paypalCaptureId: capture.captureId, note: 'PayPal is holding this payment for review.' },
        });
        after.push(statusEvent(order, CheckoutStatus.CAPTURE_PENDING));
      }
      return after;
    }
    if (CLOSED_UNPAID.includes(order.status)) return after;
    await tx.checkoutOrder.update({
      where: { id: order.id },
      data: {
        status: CheckoutStatus.FAILED,
        rewardTokenId: null,
        paypalCaptureId: capture.captureId,
        note: `PayPal did not complete the payment (${capture.status}). Nothing was charged.`,
      },
    });
    after.push(statusEvent(order, CheckoutStatus.FAILED));
    return after;
  }

  if (CLOSED_UNPAID.includes(order.status)) {
    await tx.checkoutOrder.update({
      where: { id: order.id },
      data: {
        status: CheckoutStatus.NEEDS_REVIEW,
        paypalCaptureId: capture.captureId,
        note: 'PayPal captured a payment for an order that was already closed. Refund it.',
      },
    });
    after.push(statusEvent(order, CheckoutStatus.NEEDS_REVIEW));
    return after;
  }

  const captured = parseAmount(capture.amount);
  if (capture.currency !== order.currency || !captured || !captured.equals(order.amountToPay)) {
    await tx.checkoutOrder.update({
      where: { id: order.id },
      data: {
        status: CheckoutStatus.NEEDS_REVIEW,
        paypalCaptureId: capture.captureId,
        note: `PayPal captured ${capture.currency} ${capture.amount}, but the order expected ${order.currency} ${order.amountToPay.toFixed(2)}. Nothing was redeemed or earned.`,
      },
    });
    after.push(statusEvent(order, CheckoutStatus.NEEDS_REVIEW));
    logger.warn({ checkoutId: order.id, captured: capture.amount, expected: order.amountToPay.toFixed(2) }, 'Captured amount mismatch');
    return after;
  }

  // The money is in.
  await tx.checkoutOrder.update({
    where: { id: order.id },
    data: { status: CheckoutStatus.CAPTURED, paypalCaptureId: capture.captureId },
  });

  let redemptionId = order.redemptionId;
  let settlementRef = order.redemptionSettlementRef;
  if (order.rewardTokenId && !redemptionId) {
    const redeemed = await redeemHeldReward(order);
    if (!redeemed.ok) {
      await tx.checkoutOrder.update({
        where: { id: order.id },
        data: {
          status: CheckoutStatus.NEEDS_REVIEW,
          note: `Paid, but the reward could not be redeemed (${redeemed.reason}). Review before settling.`,
        },
      });
      after.push(statusEvent(order, CheckoutStatus.NEEDS_REVIEW));
      return after;
    }
    redemptionId = redeemed.redemptionId;
    settlementRef = redeemed.settlementRef;
  }

  let earnedTokenId = order.earnedTokenId;
  let note = order.note;
  if (order.earnRuleId && !earnedTokenId) {
    const earned = await issueEarnedReward(order);
    earnedTokenId = earned.tokenId;
    if (earned.note) note = earned.note;
  }

  const platformFee = platformFeeFor(order.amountToPay);
  await tx.checkoutOrder.update({
    where: { id: order.id },
    data: {
      status: CheckoutStatus.COMPLETED,
      redemptionId,
      redemptionSettlementRef: settlementRef,
      earnedTokenId,
      platformFee,
      completedAt: new Date(),
      note,
    },
  });

  after.push(() => {
    emitEvent(EventType.CHECKOUT_COMPLETED, {
      checkoutId: order.id,
      merchantId: order.merchantId,
      customerId: order.customerId,
      subtotal: toMoneyNumber(order.subtotal),
      rewardAmount: toMoneyNumber(order.rewardAmount),
      amountPaid: toMoneyNumber(order.amountToPay),
      earnedAmount: earnedTokenId ? toMoneyNumber(order.expectedEarn) : 0,
      platformFee: toMoneyNumber(platformFee),
      paypalCaptureId: capture.captureId,
      source,
    });
    void invalidateWalletCache(order.customerId);
  });
  logger.info({ checkoutId: order.id, source, captureId: capture.captureId }, 'Checkout completed');
  return after;
}

export async function finalizeCapture(checkoutId: string, capture: CaptureInfo, source: FinalizeSource): Promise<CheckoutOrderView> {
  const after = await withOrderLock(checkoutId, (tx) => finalizeLocked(tx, checkoutId, capture, source));
  for (const run of after) run();
  return loadOrderView(checkoutId);
}
